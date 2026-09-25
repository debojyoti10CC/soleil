use borsh::{from_slice, to_vec};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program, sysvar,
};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    clock::Clock,
    signature::{Keypair, Signer},
    system_instruction,
    transaction::Transaction,
};

use soleil_settlement::{
    process_instruction, Market, Position, SoleilInstruction, MARKET_SEED, POSITION_SEED,
    QUOTE_SEED, SOL_UNDERLYING,
};

const PROGRAM_ID: Pubkey = Pubkey::new_from_array([7u8; 32]);
const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

fn market_pda(strike_cents: u64, expiry_at: i64, kind: u8) -> Pubkey {
    let strike_bytes = strike_cents.to_le_bytes();
    let expiry_bytes = expiry_at.to_le_bytes();
    Pubkey::find_program_address(
        &[
            MARKET_SEED,
            SOL_UNDERLYING,
            &strike_bytes,
            &expiry_bytes,
            &[kind],
        ],
        &PROGRAM_ID,
    )
    .0
}

fn quote_pda(market: &Pubkey, maker: &Pubkey, nonce: u64) -> Pubkey {
    let nonce_bytes = nonce.to_le_bytes();
    Pubkey::find_program_address(
        &[QUOTE_SEED, market.as_ref(), maker.as_ref(), &nonce_bytes],
        &PROGRAM_ID,
    )
    .0
}

fn position_pda(owner: &Pubkey, market: &Pubkey, expiry_at: i64) -> Pubkey {
    let expiry_bytes = expiry_at.to_le_bytes();
    Pubkey::find_program_address(
        &[
            POSITION_SEED,
            owner.as_ref(),
            market.as_ref(),
            &expiry_bytes,
        ],
        &PROGRAM_ID,
    )
    .0
}

fn instruction(accounts: Vec<AccountMeta>, data: SoleilInstruction) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts,
        data: to_vec(&data).expect("instruction serializes"),
    }
}

async fn send(
    context: &mut ProgramTestContext,
    instructions: Vec<Instruction>,
    extra_signers: &[&Keypair],
) -> Result<(), solana_sdk::transport::TransportError> {
    let recent_blockhash = context
        .get_new_latest_blockhash()
        .await
        .expect("latest blockhash");
    let mut signers = vec![&context.payer];
    signers.extend_from_slice(extra_signers);
    let transaction = Transaction::new_signed_with_payer(
        &instructions,
        Some(&context.payer.pubkey()),
        &signers,
        recent_blockhash,
    );
    context.banks_client.process_transaction(transaction).await.map_err(Into::into)
}

async fn lifecycle(side: u8, settle_at_expiry: bool) {
    let mut program_test = ProgramTest::new(
        "soleil_settlement",
        PROGRAM_ID,
        processor!(process_instruction),
    );
    program_test.set_compute_max_units(400_000);
    let mut context = program_test.start_with_context().await;
    let maker = Keypair::new();
    let trader = Keypair::new();
    let funding = 10 * LAMPORTS_PER_SOL;
    let payer = context.payer.pubkey();

    send(
        &mut context,
        vec![
            system_instruction::transfer(&payer, &maker.pubkey(), funding),
            system_instruction::transfer(&payer, &trader.pubkey(), funding),
        ],
        &[],
    )
    .await
    .expect("fund test wallets");

    let clock: Clock = context
        .banks_client
        .get_sysvar()
        .await
        .expect("clock sysvar");
    let expiry_at = clock.unix_timestamp + 3_600;
    let strike_cents = 18_000;
    let kind = 1;
    let market = market_pda(strike_cents, expiry_at, kind);
    let nonce = 41;
    let quote = quote_pda(&market, &maker.pubkey(), nonce);
    let position = position_pda(&trader.pubkey(), &market, expiry_at);

    send(
        &mut context,
        vec![instruction(
            vec![
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(market, false),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(sysvar::rent::ID, false),
            ],
            SoleilInstruction::InitializeMarket {
                expiry_at,
                strike_cents,
                kind,
            },
        )],
        &[&maker],
    )
    .await
    .expect("initialize market");

    send(
        &mut context,
        vec![instruction(
            vec![
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(market, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            SoleilInstruction::DepositLiquidity {
                amount_lamports: 5 * LAMPORTS_PER_SOL,
            },
        )],
        &[&maker],
    )
    .await
    .expect("deposit liquidity");

    send(
        &mut context,
        vec![instruction(
            vec![
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new_readonly(market, false),
                AccountMeta::new(quote, false),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(sysvar::rent::ID, false),
            ],
            SoleilInstruction::PublishQuote {
                side: 1 - side,
                price_cents: 100,
                size_units: LAMPORTS_PER_SOL,
                expires_at: expiry_at - 60,
                nonce,
                premium_lamports_per_unit: 20_000_000,
                collateral_lamports_per_unit: LAMPORTS_PER_SOL,
            },
        )],
        &[&maker],
    )
    .await
    .expect("publish ask quote");

    send(
        &mut context,
        vec![instruction(
            vec![
                AccountMeta::new(trader.pubkey(), true),
                AccountMeta::new(market, false),
                AccountMeta::new(quote, false),
                AccountMeta::new(position, false),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(sysvar::rent::ID, false),
            ],
            SoleilInstruction::OpenPosition {
                side,
                quantity_units: LAMPORTS_PER_SOL,
                premium_cents: 100,
                floor_cents: 0,
                quote_nonce: nonce,
                expiry_at,
                premium_lamports: 20_000_000,
                collateral_lamports: if side == 1 { LAMPORTS_PER_SOL } else { 0 },
            },
        )],
        &[&trader],
    )
    .await
    .expect("open long position");

    let market_account = context
        .banks_client
        .get_account(market)
        .await
        .expect("market lookup")
        .expect("market exists");
    let market_state: Market = from_slice(&market_account.data).expect("market decodes");
    assert_eq!(
        market_state.liquidity_lamports,
        if side == 0 { 5 * LAMPORTS_PER_SOL + 20_000_000 } else { 6 * LAMPORTS_PER_SOL - 20_000_000 }
    );
    assert_eq!(market_state.reserved_units, LAMPORTS_PER_SOL);
    assert_eq!(market_state.reserved_lamports, LAMPORTS_PER_SOL);

    let blocked_withdrawal = send(
        &mut context,
        vec![instruction(
            vec![
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(market, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            SoleilInstruction::WithdrawLiquidity {
                amount_lamports: market_state.liquidity_lamports - market_state.reserved_lamports + 1,
            },
        )],
        &[&maker],
    )
    .await;
    assert!(
        blocked_withdrawal.is_err(),
        "reserved liquidity must be withdraw-protected"
    );

    let close = instruction(
        vec![AccountMeta::new(trader.pubkey(), true), AccountMeta::new(market, false),
            AccountMeta::new(position, false), AccountMeta::new_readonly(system_program::ID, false)],
        SoleilInstruction::ClosePosition,
    );
    if side == 1 {
        assert!(send(&mut context, vec![close.clone()], &[&trader]).await.is_err(), "seller cannot cancel liability and keep premium");
    }
    if settle_at_expiry {
        let owner_before = context.banks_client.get_balance(trader.pubkey()).await.unwrap();
        let mut clock: Clock = context.banks_client.get_sysvar().await.unwrap();
        clock.unix_timestamp = expiry_at + 1;
        context.set_sysvar(&clock);
        let settle_accounts = vec![AccountMeta::new_readonly(maker.pubkey(), true), AccountMeta::new(market, false),
            AccountMeta::new(position, false), AccountMeta::new_readonly(system_program::ID, false), AccountMeta::new(trader.pubkey(), false)];
        assert!(send(&mut context, vec![instruction(settle_accounts.clone(), SoleilInstruction::Settle {
            oracle_price_cents: 16_500, observed_at: expiry_at - 1,
        })], &[&maker]).await.is_err(), "pre-expiry observations cannot settle");
        let settle_ix = instruction(settle_accounts, SoleilInstruction::Settle {
            oracle_price_cents: 16_500, observed_at: expiry_at,
        });
        send(&mut context, vec![settle_ix.clone()], &[&maker]).await.expect("settlement transfers program-owned lamports");
        let owner_after = context.banks_client.get_balance(trader.pubkey()).await.unwrap();
        let payout = 1_500 * LAMPORTS_PER_SOL / 16_500;
        assert_eq!(owner_after - owner_before, if side == 0 { payout } else { LAMPORTS_PER_SOL - payout });
        assert!(send(&mut context, vec![settle_ix], &[&maker]).await.is_err(), "double settlement is rejected");
    } else {
        send(&mut context, vec![close], &[&trader]).await.expect("long holder may abandon the option");
    }

    let market_account = context
        .banks_client
        .get_account(market)
        .await
        .expect("market lookup after close")
        .expect("market exists after close");
    let market_state: Market =
        from_slice(&market_account.data).expect("market decodes after close");
    assert_eq!(market_state.reserved_units, 0);
    assert_eq!(market_state.reserved_lamports, 0);

    let position_account = context
        .banks_client
        .get_account(position)
        .await
        .expect("position lookup")
        .expect("position exists");
    let position_state: Position = from_slice(&position_account.data).expect("position decodes");
    assert_eq!(position_state.status, if settle_at_expiry { 3 } else { 2 });
    assert_eq!(position_state.reserved_lamports, 0);
    assert_eq!(position_state.premium_lamports, 20_000_000);
}

#[tokio::test]
async fn long_abandonment_releases_reserves() { lifecycle(0, false).await; }

#[tokio::test]
async fn long_settlement_pays_owner_and_rejects_replay() { lifecycle(0, true).await; }

