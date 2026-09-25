use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::{clock::Clock, rent::Rent, Sysvar},
};
use solana_system_interface::instruction as system_instruction;
use thiserror::Error;

pub const MARKET_SEED: &[u8] = b"market";
pub const POSITION_SEED: &[u8] = b"position";
pub const QUOTE_SEED: &[u8] = b"quote";
pub const SOL_UNDERLYING: &[u8] = b"SOL";
pub const MAX_ORACLE_AGE_SECONDS: i64 = 300;

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq)]
pub enum SoleilInstruction {
    InitializeMarket {
        expiry_at: i64,
        strike_cents: u64,
        kind: u8,
    },
    OpenPosition {
        side: u8,
        quantity_units: u64,
        premium_cents: u64,
        floor_cents: u64,
        quote_nonce: u64,
        expiry_at: i64,
        premium_lamports: u64,
        collateral_lamports: u64,
    },
    ClosePosition,
    Settle {
        oracle_price_cents: u64,
        observed_at: i64,
    },
    PublishQuote {
        side: u8,
        price_cents: u64,
        size_units: u64,
        expires_at: i64,
        nonce: u64,
        premium_lamports_per_unit: u64,
        collateral_lamports_per_unit: u64,
    },
    DepositLiquidity {
        amount_lamports: u64,
    },
    WithdrawLiquidity {
        amount_lamports: u64,
    },
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq)]
pub struct Market {
    pub authority: Pubkey,
    pub oracle: Pubkey,
    pub expiry_at: i64,
    pub strike_cents: u64,
    pub kind: u8,
    pub bump: u8,
    pub liquidity_lamports: u64,
    pub reserved_units: u64,
    pub reserved_lamports: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq)]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub side: u8,
    pub quantity_units: u64,
    pub premium_cents: u64,
    pub floor_cents: u64,
    pub opened_at: i64,
    pub settled_at: i64,
    pub payout_cents: u64,
    pub status: u8,
    pub premium_lamports: u64,
    pub collateral_lamports: u64,
    pub payout_lamports: u64,
    pub reserved_lamports: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq)]
pub struct Quote {
    pub maker: Pubkey,
    pub market: Pubkey,
    pub side: u8,
    pub price_cents: u64,
    pub size_units: u64,
    pub filled_units: u64,
    pub expires_at: i64,
    pub nonce: u64,
    pub active: u8,
    pub premium_lamports_per_unit: u64,
    pub collateral_lamports_per_unit: u64,
}

#[derive(Error, Debug, Copy, Clone)]
pub enum SoleilError {
    #[error("invalid PDA")]
    InvalidPda,
    #[error("account is already initialized")]
    AlreadyInitialized,
    #[error("unauthorized signer")]
    Unauthorized,
    #[error("market is not initialized")]
    InvalidMarket,
    #[error("position is not open")]
    InvalidPosition,
    #[error("market has not expired")]
    NotExpired,
    #[error("market has expired")]
    Expired,
    #[error("invalid instruction data")]
    InvalidInstruction,
    #[error("invalid parameters")]
    InvalidParameters,
    #[error("insufficient market liquidity")]
    InsufficientLiquidity,
}

impl From<SoleilError> for ProgramError {
    fn from(error: SoleilError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let instruction =
        SoleilInstruction::try_from_slice(data).map_err(|_| SoleilError::InvalidInstruction)?;
    match instruction {
        SoleilInstruction::InitializeMarket {
            expiry_at,
            strike_cents,
            kind,
        } => initialize_market(program_id, accounts, expiry_at, strike_cents, kind),
        SoleilInstruction::OpenPosition {
            side,
            quantity_units,
            premium_cents,
            floor_cents,
            quote_nonce,
            expiry_at,
            premium_lamports,
            collateral_lamports,
        } => open_position(
            program_id,
            accounts,
            side,
            quantity_units,
            premium_cents,
            floor_cents,
            quote_nonce,
            expiry_at,
            premium_lamports,
            collateral_lamports,
        ),
        SoleilInstruction::ClosePosition => close_position(program_id, accounts),
        SoleilInstruction::Settle {
            oracle_price_cents,
            observed_at,
        } => settle(program_id, accounts, oracle_price_cents, observed_at),
        SoleilInstruction::PublishQuote {
            side,
            price_cents,
            size_units,
            expires_at,
            nonce,
            premium_lamports_per_unit,
            collateral_lamports_per_unit,
        } => publish_quote(
            program_id,
            accounts,
            side,
            price_cents,
            size_units,
            expires_at,
            nonce,
            premium_lamports_per_unit,
            collateral_lamports_per_unit,
        ),
        SoleilInstruction::DepositLiquidity { amount_lamports } => {
            deposit_liquidity(program_id, accounts, amount_lamports)
        }
        SoleilInstruction::WithdrawLiquidity { amount_lamports } => {
            withdraw_liquidity(program_id, accounts, amount_lamports)
        }
    }
}

fn initialize_market(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    expiry_at: i64,
    strike_cents: u64,
    kind: u8,
) -> ProgramResult {
    let mut accounts = accounts.iter();
    let authority = next_account_info(&mut accounts)?;
    let market = next_account_info(&mut accounts)?;
    let system_program = next_account_info(&mut accounts)?;
    let rent_account = next_account_info(&mut accounts)?;
    if !authority.is_signer || market.owner != &solana_program::system_program::ID {
        return Err(SoleilError::Unauthorized.into());
    }
    if expiry_at <= Clock::get()?.unix_timestamp || strike_cents == 0 || kind > 1 {
        return Err(SoleilError::InvalidParameters.into());
    }
    let strike_bytes = strike_cents.to_le_bytes();
    let expiry_bytes = expiry_at.to_le_bytes();
    let kind_bytes = [kind];
    let market_seeds = [
        MARKET_SEED,
        SOL_UNDERLYING,
        strike_bytes.as_slice(),
        expiry_bytes.as_slice(),
        kind_bytes.as_slice(),
    ];
    let (expected, bump) = Pubkey::find_program_address(&market_seeds, program_id);
    if expected != *market.key {
        return Err(SoleilError::InvalidPda.into());
    }
    if !market.data_is_empty() {
        return Err(SoleilError::AlreadyInitialized.into());
    }
    let rent = Rent::from_account_info(rent_account)?;
    let space = borsh::to_vec(&Market {
        authority: *authority.key,
        oracle: *authority.key,
        expiry_at,
        strike_cents,
        kind,
        bump,
        liquidity_lamports: 0,
        reserved_units: 0,
        reserved_lamports: 0,
    })
    .map_err(|_| SoleilError::InvalidInstruction)?
    .len();
    let create = system_instruction::create_account(
        authority.key,
        market.key,
        rent.minimum_balance(space),
        space as u64,
        program_id,
    );
    invoke_signed(
        &create,
        &[authority.clone(), market.clone(), system_program.clone()],
        &[&[
            MARKET_SEED,
            SOL_UNDERLYING,
            &strike_bytes,
            &expiry_bytes,
            &kind_bytes,
            &[bump],
        ]],
    )?;
    let state = Market {
        authority: *authority.key,
        oracle: *authority.key,
        expiry_at,
        strike_cents,
        kind,
        bump,
        liquidity_lamports: 0,
        reserved_units: 0,
        reserved_lamports: 0,
    };
    state
        .serialize(&mut &mut market.data.borrow_mut()[..])
        .map_err(|_| SoleilError::InvalidInstruction.into())
}

fn validate_market_pda(
    program_id: &Pubkey,
    market_account: &AccountInfo,
    market: &Market,
) -> ProgramResult {
    let strike_bytes = market.strike_cents.to_le_bytes();
    let expiry_bytes = market.expiry_at.to_le_bytes();
    let kind_bytes = [market.kind];
    let (expected, _) = Pubkey::find_program_address(
        &[
            MARKET_SEED,
            SOL_UNDERLYING,
            &strike_bytes,
            &expiry_bytes,
            &kind_bytes,
        ],
        program_id,
    );
    if expected != *market_account.key {
        return Err(SoleilError::InvalidPda.into());
    }
    Ok(())
}

fn validate_position_pda(
    program_id: &Pubkey,
    position_account: &AccountInfo,
    owner: &Pubkey,
    market: &Pubkey,
    expiry_at: i64,
) -> ProgramResult {
    let expiry_bytes = expiry_at.to_le_bytes();
    let (expected, _) = Pubkey::find_program_address(
        &[
            POSITION_SEED,
            owner.as_ref(),
            market.as_ref(),
            &expiry_bytes,
        ],
        program_id,
    );
    if expected != *position_account.key {
        return Err(SoleilError::InvalidPda.into());
    }
    Ok(())
}

fn validate_quote_pda(
    program_id: &Pubkey,
    quote_account: &AccountInfo,
    market: &Pubkey,
    maker: &Pubkey,
    nonce: u64,
) -> ProgramResult {
    let nonce_bytes = nonce.to_le_bytes();
    let (expected, _) = Pubkey::find_program_address(
        &[QUOTE_SEED, market.as_ref(), maker.as_ref(), &nonce_bytes],
        program_id,
    );
    if expected != *quote_account.key {
        return Err(SoleilError::InvalidPda.into());
    }
    Ok(())
}


fn transfer_from_market(
    program_id: &Pubkey,
    market: &AccountInfo,
    recipient: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    if market.owner != program_id || market.key == recipient.key || !market.is_writable || !recipient.is_writable {
        return Err(SoleilError::Unauthorized.into());
    }
    let remaining = market.lamports().checked_sub(amount).ok_or(SoleilError::InsufficientLiquidity)?;
    if remaining < Rent::get()?.minimum_balance(market.data_len()) {
        return Err(SoleilError::InsufficientLiquidity.into());
    }
    let received = recipient.lamports().checked_add(amount).ok_or(SoleilError::InvalidParameters)?;
    **market.try_borrow_mut_lamports()? = remaining;
    **recipient.try_borrow_mut_lamports()? = received;
    Ok(())
}

fn proportional_lamports(per_unit: u64, quantity_units: u64) -> Result<u64, SoleilError> {
    u64::try_from((per_unit as u128) * (quantity_units as u128) / 1_000_000_000)
        .map_err(|_| SoleilError::InvalidParameters)
}

fn publish_quote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    side: u8,
    price_cents: u64,
    size_units: u64,
    expires_at: i64,
    nonce: u64,
    premium_lamports_per_unit: u64,
    collateral_lamports_per_unit: u64,
) -> ProgramResult {
    let mut accounts = accounts.iter();
    let maker = next_account_info(&mut accounts)?;
    let market_account = next_account_info(&mut accounts)?;
    let quote_account = next_account_info(&mut accounts)?;
    let system_program = next_account_info(&mut accounts)?;
    let rent_account = next_account_info(&mut accounts)?;
    if !maker.is_signer
        || market_account.owner != program_id
        || quote_account.owner != &solana_program::system_program::ID
    {
        return Err(SoleilError::Unauthorized.into());
    }
    let market = Market::try_from_slice(&market_account.data.borrow())
        .map_err(|_| SoleilError::InvalidMarket)?;
    validate_market_pda(program_id, market_account, &market)?;
    if market.authority != *maker.key
        || side > 1
        || price_cents == 0
        || size_units == 0
        || premium_lamports_per_unit == 0
        || collateral_lamports_per_unit == 0
        || expires_at <= Clock::get()?.unix_timestamp
        || expires_at > market.expiry_at
        || !quote_account.data_is_empty()
    {
        return Err(SoleilError::InvalidParameters.into());
    }
    validate_quote_pda(
        program_id,
        quote_account,
        market_account.key,
        maker.key,
        nonce,
    )?;
    let rent = Rent::from_account_info(rent_account)?;
    let initial = Quote {
        maker: *maker.key,
        market: *market_account.key,
        side,
        price_cents,
        size_units,
        filled_units: 0,
        expires_at,
        nonce,
        active: 1,
        premium_lamports_per_unit,
        collateral_lamports_per_unit,
    };
    let space = borsh::to_vec(&initial)
        .map_err(|_| SoleilError::InvalidInstruction)?
        .len();
    let nonce_bytes = nonce.to_le_bytes();
    let (_, bump) = Pubkey::find_program_address(
        &[
            QUOTE_SEED,
            market_account.key.as_ref(),
            maker.key.as_ref(),
            &nonce_bytes,
        ],
        program_id,
    );
    let create = system_instruction::create_account(
        maker.key,
        quote_account.key,
        rent.minimum_balance(space),
        space as u64,
        program_id,
    );
    invoke_signed(
        &create,
        &[maker.clone(), quote_account.clone(), system_program.clone()],
        &[&[
            QUOTE_SEED,
            market_account.key.as_ref(),
            maker.key.as_ref(),
            &nonce_bytes,
            &[bump],
        ]],
    )?;
    initial
        .serialize(&mut &mut quote_account.data.borrow_mut()[..])
        .map_err(|_| SoleilError::InvalidInstruction.into())
}

fn deposit_liquidity(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount_lamports: u64,
) -> ProgramResult {
    let mut accounts = accounts.iter();
    let authority = next_account_info(&mut accounts)?;
    let market_account = next_account_info(&mut accounts)?;
    let system_program = next_account_info(&mut accounts)?;
    if !authority.is_signer || market_account.owner != program_id || amount_lamports == 0 {
        return Err(SoleilError::InvalidParameters.into());
    }
    let mut market = Market::try_from_slice(&market_account.data.borrow())
        .map_err(|_| SoleilError::InvalidMarket)?;
    validate_market_pda(program_id, market_account, &market)?;
    if market.authority != *authority.key {
        return Err(SoleilError::Unauthorized.into());
    }
    let transfer = system_instruction::transfer(authority.key, market_account.key, amount_lamports);
    solana_program::program::invoke(
        &transfer,
        &[
            authority.clone(),
            market_account.clone(),
            system_program.clone(),
        ],
    )?;
    market.liquidity_lamports = market
        .liquidity_lamports
        .checked_add(amount_lamports)
        .ok_or(SoleilError::InvalidParameters)?;
    market
        .serialize(&mut &mut market_account.data.borrow_mut()[..])
        .map_err(|_| SoleilError::InvalidInstruction.into())
}

fn withdraw_liquidity(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount_lamports: u64,
) -> ProgramResult {
    let mut accounts = accounts.iter();
    let authority = next_account_info(&mut accounts)?;
    let market_account = next_account_info(&mut accounts)?;
    let system_program = next_account_info(&mut accounts)?;
    if !authority.is_signer || market_account.owner != program_id || amount_lamports == 0 {
        return Err(SoleilError::InvalidParameters.into());
    }
    let mut market = Market::try_from_slice(&market_account.data.borrow())
        .map_err(|_| SoleilError::InvalidMarket)?;
    validate_market_pda(program_id, market_account, &market)?;
    if market.authority != *authority.key {
        return Err(SoleilError::Unauthorized.into());
    }
    if market
        .liquidity_lamports
        .saturating_sub(market.reserved_units)
        < amount_lamports
        || market
            .liquidity_lamports
            .saturating_sub(market.reserved_lamports)
            < amount_lamports
    {
        return Err(SoleilError::InsufficientLiquidity.into());
    }
    let rent_floor = Rent::get()?.minimum_balance(market_account.data_len());
    if market_account.lamports().saturating_sub(amount_lamports) < rent_floor {
        return Err(SoleilError::InsufficientLiquidity.into());
    }
    market.liquidity_lamports -= amount_lamports;
    market
        .serialize(&mut &mut market_account.data.borrow_mut()[..])
        .map_err(|_| SoleilError::InvalidInstruction)?;
    transfer_from_market(program_id, market_account, authority, amount_lamports)?;
    Ok(())
}

fn open_position(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    side: u8,
    quantity_units: u64,
    premium_cents: u64,
    floor_cents: u64,
    quote_nonce: u64,
    expiry_at: i64,
    premium_lamports: u64,
    collateral_lamports: u64,
) -> ProgramResult {
    let mut accounts = accounts.iter();
    let owner = next_account_info(&mut accounts)?;
    let market_account = next_account_info(&mut accounts)?;
    let quote_account = next_account_info(&mut accounts)?;
    let position = next_account_info(&mut accounts)?;
    let system_program = next_account_info(&mut accounts)?;
    let rent_account = next_account_info(&mut accounts)?;
    if !owner.is_signer
        || market_account.owner != program_id
        || quote_account.owner != program_id
        || system_program.key != &solana_program::system_program::ID
    {
        return Err(SoleilError::InvalidMarket.into());
    }
    let mut market = Market::try_from_slice(&market_account.data.borrow())
        .map_err(|_| SoleilError::InvalidMarket)?;
    validate_market_pda(program_id, market_account, &market)?;
    let mut quote = Quote::try_from_slice(&quote_account.data.borrow())
        .map_err(|_| SoleilError::InvalidInstruction)?;
    validate_quote_pda(
        program_id,
        quote_account,
        market_account.key,
        &quote.maker,
        quote_nonce,
    )?;
    if market.expiry_at <= Clock::get()?.unix_timestamp {
        return Err(SoleilError::Expired.into());
    }
    let expected_premium_lamports =
        proportional_lamports(quote.premium_lamports_per_unit, quantity_units)?;
    let expected_collateral_lamports =
        proportional_lamports(quote.collateral_lamports_per_unit, quantity_units)?;
    if side > 1
        || quantity_units == 0
        || quote.market != *market_account.key
        || quote.nonce != quote_nonce
        || quote.active != 1
        || quote.expires_at <= Clock::get()?.unix_timestamp
        || quote.side == side
        || premium_cents != quote.price_cents
        || premium_lamports != expected_premium_lamports
        || premium_lamports == 0
        || expected_collateral_lamports == 0
        || (side == 1 && collateral_lamports != expected_collateral_lamports)
        || (side == 0 && collateral_lamports != 0)
        || (side == 1 && collateral_lamports == 0)
        || quote.filled_units > quote.size_units
        || quantity_units > quote.size_units - quote.filled_units
        || quantity_units
            > market
                .liquidity_lamports
                .saturating_sub(market.reserved_units)
        || market.expiry_at != expiry_at
        || position.owner != &solana_program::system_program::ID
    {
        return Err(SoleilError::InvalidPda.into());
    }
    let expiry_bytes = expiry_at.to_le_bytes();
    let (expected, bump) = Pubkey::find_program_address(
        &[
            POSITION_SEED,
            owner.key.as_ref(),
            market_account.key.as_ref(),
            &expiry_bytes,
        ],
        program_id,
    );
    if expected != *position.key {
        return Err(SoleilError::InvalidPda.into());
    }
    let rent = Rent::from_account_info(rent_account)?;
    let next_reserved = market
        .reserved_units
        .checked_add(quantity_units)
        .ok_or(SoleilError::InsufficientLiquidity)?;
    if side == 0
        && expected_collateral_lamports
            > market
                .liquidity_lamports
                .saturating_sub(market.reserved_lamports)
    {
        return Err(SoleilError::InsufficientLiquidity.into());
    }
    let next_reserved_lamports = market
        .reserved_lamports
        .checked_add(expected_collateral_lamports)
        .ok_or(SoleilError::InsufficientLiquidity)?;
    let next_liquidity = if side == 0 {
        market
            .liquidity_lamports
            .checked_add(premium_lamports)
            .ok_or(SoleilError::InvalidParameters)?
    } else {
        let with_collateral = market
            .liquidity_lamports
            .checked_add(collateral_lamports)
            .ok_or(SoleilError::InvalidParameters)?;
        if with_collateral < premium_lamports {
            return Err(SoleilError::InsufficientLiquidity.into());
        }
        with_collateral - premium_lamports
    };
    if next_liquidity < next_reserved_lamports {
        return Err(SoleilError::InsufficientLiquidity.into());
    }
    if side == 1
        && market_account
            .lamports()
            .saturating_add(collateral_lamports)
            .saturating_sub(premium_lamports)
            < rent.minimum_balance(market_account.data_len())
    {
        return Err(SoleilError::InsufficientLiquidity.into());
    }
    if side == 0 {
        let transfer =
            system_instruction::transfer(owner.key, market_account.key, premium_lamports);
        solana_program::program::invoke(
            &transfer,
            &[
                owner.clone(),
                market_account.clone(),
                system_program.clone(),
            ],
        )?;
    } else {
        let collateral_transfer =
            system_instruction::transfer(owner.key, market_account.key, collateral_lamports);
        solana_program::program::invoke(
            &collateral_transfer,
            &[
                owner.clone(),
                market_account.clone(),
                system_program.clone(),
            ],
        )?;
        transfer_from_market(program_id, market_account, owner, premium_lamports)?;
    }
    let initial = Position {
        owner: *owner.key,
        market: *market_account.key,
        side,
        quantity_units,
        premium_cents,
        floor_cents,
        opened_at: Clock::get()?.unix_timestamp,
        settled_at: 0,
        payout_cents: 0,
        status: 1,
        premium_lamports,
        collateral_lamports,
        payout_lamports: 0,
        reserved_lamports: expected_collateral_lamports,
    };
    let space = borsh::to_vec(&initial)
        .map_err(|_| SoleilError::InvalidInstruction)?
        .len();
    let create = system_instruction::create_account(
        owner.key,
        position.key,
        rent.minimum_balance(space),
        space as u64,
        program_id,
    );
    invoke_signed(
        &create,
        &[owner.clone(), position.clone(), system_program.clone()],
        &[&[
            POSITION_SEED,
            owner.key.as_ref(),
            market_account.key.as_ref(),
            &expiry_bytes,
            &[bump],
        ]],
    )?;
    initial
        .serialize(&mut &mut position.data.borrow_mut()[..])
        .map_err(|_| SoleilError::InvalidInstruction)?;
    quote.filled_units = quote.filled_units.saturating_add(quantity_units);
    if quote.filled_units == quote.size_units {
        quote.active = 0;
    }
    market.reserved_units = next_reserved;
    market.reserved_lamports = next_reserved_lamports;
    market.liquidity_lamports = next_liquidity;
    quote
        .serialize(&mut &mut quote_account.data.borrow_mut()[..])
        .map_err(|_| SoleilError::InvalidInstruction)?;
    market
        .serialize(&mut &mut market_account.data.borrow_mut()[..])
        .map_err(|_| SoleilError::InvalidInstruction.into())
}

fn close_position(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let mut accounts = accounts.iter();
    let owner = next_account_info(&mut accounts)?;
    let market_account = next_account_info(&mut accounts)?;
    let position_account = next_account_info(&mut accounts)?;
    let system_program = next_account_info(&mut accounts)?;
    if !owner.is_signer
        || market_account.owner != program_id
        || position_account.owner != program_id
        || system_program.key != &solana_program::system_program::ID
    {
        return Err(SoleilError::Unauthorized.into());
    }
    let mut market = Market::try_from_slice(&market_account.data.borrow())
        .map_err(|_| SoleilError::InvalidMarket)?;
    validate_market_pda(program_id, market_account, &market)?;
    let mut position = Position::try_from_slice(&position_account.data.borrow())
        .map_err(|_| SoleilError::InvalidPosition)?;
    if position.owner != *owner.key
        || position.market != *market_account.key
        || position.status != 1
    {
        return Err(SoleilError::InvalidPosition.into());
    }
    validate_position_pda(
        program_id,
        position_account,
        &position.owner,
        &position.market,
        market.expiry_at,
    )?;
    if position.side == 1 {
        return Err(SoleilError::Unauthorized.into());
    }
    if market.expiry_at <= Clock::get()?.unix_timestamp {
        return Err(SoleilError::Expired.into());
    }
    if position.side == 1 && position.collateral_lamports > 0 {
        if market.liquidity_lamports < position.collateral_lamports {
            return Err(SoleilError::InsufficientLiquidity.into());
        }
        if market_account
            .lamports()
            .saturating_sub(position.collateral_lamports)
            < Rent::get()?.minimum_balance(market_account.data_len())
        {
            return Err(SoleilError::InsufficientLiquidity.into());
        }
        transfer_from_market(program_id, market_account, owner, position.collateral_lamports)?;
        market.liquidity_lamports -= position.collateral_lamports;
        position.collateral_lamports = 0;
    }
    market.reserved_lamports = market
        .reserved_lamports
        .checked_sub(position.reserved_lamports)
        .ok_or(SoleilError::InvalidPosition)?;
    position.reserved_lamports = 0;
    market.reserved_units = market
        .reserved_units
        .checked_sub(position.quantity_units)
        .ok_or(SoleilError::InvalidPosition)?;
    position.status = 2;
    position
        .serialize(&mut &mut position_account.data.borrow_mut()[..])
        .map_err(|_| SoleilError::InvalidInstruction)?;
    market
        .serialize(&mut &mut market_account.data.borrow_mut()[..])
        .map_err(|_| SoleilError::InvalidInstruction.into())
}

fn settle(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    oracle_price_cents: u64,
    observed_at: i64,
) -> ProgramResult {
    let mut accounts = accounts.iter();
    let oracle = next_account_info(&mut accounts)?;
    let market_account = next_account_info(&mut accounts)?;
    let position_account = next_account_info(&mut accounts)?;
    let system_program = next_account_info(&mut accounts)?;
    if !oracle.is_signer
        || market_account.owner != program_id
        || position_account.owner != program_id
        || system_program.key != &solana_program::system_program::ID
    {
        return Err(SoleilError::Unauthorized.into());
    }
    let mut market = Market::try_from_slice(&market_account.data.borrow())
        .map_err(|_| SoleilError::InvalidMarket)?;
    validate_market_pda(program_id, market_account, &market)?;
    if market.oracle != *oracle.key {
        return Err(SoleilError::Unauthorized.into());
    }
    if Clock::get()?.unix_timestamp < market.expiry_at {
        return Err(SoleilError::NotExpired.into());
    }
    let mut position = Position::try_from_slice(&position_account.data.borrow())
        .map_err(|_| SoleilError::InvalidPosition)?;
    if position.market != *market_account.key || position.status != 1 {
        return Err(SoleilError::InvalidPosition.into());
    }
    validate_position_pda(
        program_id,
        position_account,
        &position.owner,
        &position.market,
        market.expiry_at,
    )?;
    let owner_account = accounts
        .clone()
        .find(|account| account.key == &position.owner)
        .ok_or(SoleilError::InvalidPosition)?;
    if owner_account.owner != &solana_program::system_program::ID {
        return Err(SoleilError::InvalidPosition.into());
    }
    let now = Clock::get()?.unix_timestamp;
    if oracle_price_cents == 0
        || observed_at < market.expiry_at
        || observed_at > now
        || now.saturating_sub(observed_at) > MAX_ORACLE_AGE_SECONDS
    {
        return Err(SoleilError::InvalidParameters.into());
    }
    let intrinsic = if market.kind == 0 {
        oracle_price_cents.saturating_sub(market.strike_cents)
    } else {
        market.strike_cents.saturating_sub(oracle_price_cents)
    };
    position.payout_cents = proportional_lamports(intrinsic, position.quantity_units)?;
    position.payout_lamports = u64::try_from(
        (intrinsic as u128) * (position.quantity_units as u128) / (oracle_price_cents as u128)
    ).map_err(|_| SoleilError::InvalidParameters)?;
    let other_reserves = market.reserved_lamports.checked_sub(position.reserved_lamports)
        .ok_or(SoleilError::InvalidPosition)?;
    if position.side == 0 && position.payout_lamports > market.liquidity_lamports.saturating_sub(other_reserves) {
        return Err(SoleilError::InsufficientLiquidity.into());
    }
    if position.side == 0 && position.payout_lamports > 0 {
        if market.liquidity_lamports < position.payout_lamports
            || market_account
                .lamports()
                .saturating_sub(position.payout_lamports)
                < Rent::get()?.minimum_balance(market_account.data_len())
        {
            return Err(SoleilError::InsufficientLiquidity.into());
        }
        transfer_from_market(program_id, market_account, owner_account, position.payout_lamports)?;
        market.liquidity_lamports -= position.payout_lamports;
    } else if position.side == 1 && position.collateral_lamports > 0 {
        if position.payout_lamports > position.collateral_lamports {
            return Err(SoleilError::InsufficientLiquidity.into());
        }
        let refund = position.collateral_lamports - position.payout_lamports;
        if refund > 0 {
            if market_account.lamports().saturating_sub(refund)
                < Rent::get()?.minimum_balance(market_account.data_len())
            {
                return Err(SoleilError::InsufficientLiquidity.into());
            }
            transfer_from_market(program_id, market_account, owner_account, refund)?;
            market.liquidity_lamports -= refund;
        }
        position.collateral_lamports = 0;
    }
    market.reserved_lamports = market
        .reserved_lamports
        .checked_sub(position.reserved_lamports)
        .ok_or(SoleilError::InvalidPosition)?;
    position.reserved_lamports = 0;
    market.reserved_units = market
        .reserved_units
        .checked_sub(position.quantity_units)
        .ok_or(SoleilError::InvalidPosition)?;
    position.settled_at = Clock::get()?.unix_timestamp;
    position.status = 3;
    position
        .serialize(&mut &mut position_account.data.borrow_mut()[..])
        .map_err(|_| SoleilError::InvalidInstruction)?;
    market
        .serialize(&mut &mut market_account.data.borrow_mut()[..])
        .map_err(|_| SoleilError::InvalidInstruction.into())
}

#[cfg(test)]
mod tests {
    use super::{proportional_lamports, Market, Position, Quote, SoleilError, SoleilInstruction};
    use solana_program::pubkey::Pubkey;

    fn sample_market() -> Market {
        Market {
            authority: Pubkey::new_unique(),
            oracle: Pubkey::new_unique(),
            expiry_at: 1_900_000_000,
            strike_cents: 18_000,
            kind: 1,
            bump: 255,
            liquidity_lamports: 5_000_000_000,
            reserved_units: 1_000_000_000,
            reserved_lamports: 1_000_000_000,
        }
    }

    #[test]
    fn instruction_layout_stays_borsh_compatible() {
        let bytes = borsh::to_vec(&SoleilInstruction::OpenPosition {
            side: 0,
            quantity_units: 1_000_000,
            premium_cents: 42,
            floor_cents: 20_000,
            quote_nonce: 1,
            expiry_at: 1_900_000_000,
            premium_lamports: 20_000_000,
            collateral_lamports: 0,
        })
        .expect("instruction serializes");
        assert_eq!(bytes[0], 1);
        assert_eq!(bytes.len(), 1 + 1 + 8 + 8 + 8 + 8 + 8 + 8 + 8);
    }

    #[test]
    fn publish_quote_layout_stays_borsh_compatible() {
        let bytes = borsh::to_vec(&SoleilInstruction::PublishQuote {
            side: 1,
            price_cents: 250,
            size_units: 3_000_000_000,
            expires_at: 1_900_000_000,
            nonce: 7,
            premium_lamports_per_unit: 20_000_000,
            collateral_lamports_per_unit: 1_000_000_000,
        })
        .expect("quote serializes");
        assert_eq!(bytes[0], 4);
        assert_eq!(bytes.len(), 1 + 1 + 8 + 8 + 8 + 8 + 8 + 8);
    }

    #[test]
    fn liquidity_instruction_layout_stays_borsh_compatible() {
        let deposit = borsh::to_vec(&SoleilInstruction::DepositLiquidity {
            amount_lamports: 2_000_000_000,
        })
        .expect("deposit serializes");
        let withdraw = borsh::to_vec(&SoleilInstruction::WithdrawLiquidity {
            amount_lamports: 500_000_000,
        })
        .expect("withdraw serializes");
        assert_eq!(deposit[0], 5);
        assert_eq!(withdraw[0], 6);
        assert_eq!(deposit.len(), 1 + 8);
        assert_eq!(withdraw.len(), 1 + 8);
    }

    #[test]
    fn position_account_size_matches_client_decoder() {
        let position = Position {
            owner: solana_program::pubkey::Pubkey::new_unique(),
            market: solana_program::pubkey::Pubkey::new_unique(),
            side: 0,
            quantity_units: 1_000_000_000,
            premium_cents: 100,
            floor_cents: 18_000,
            opened_at: 1_900_000_000,
            settled_at: 0,
            payout_cents: 0,
            status: 1,
            premium_lamports: 20_000_000,
            collateral_lamports: 0,
            payout_lamports: 0,
            reserved_lamports: 1_000_000_000,
        };
        assert_eq!(
            borsh::to_vec(&position).expect("position serializes").len(),
            146
        );
    }

    #[test]
    fn account_layout_sizes_match_indexer_contract() {
        let market = sample_market();
        let quote = Quote {
            maker: Pubkey::new_unique(),
            market: Pubkey::new_unique(),
            side: 1,
            price_cents: 250,
            size_units: 3_000_000_000,
            filled_units: 0,
            expires_at: 1_800_000_000,
            nonce: 7,
            active: 1,
            premium_lamports_per_unit: 20_000_000,
            collateral_lamports_per_unit: 1_000_000_000,
        };
        assert_eq!(
            borsh::to_vec(&market).expect("market serializes").len(),
            106
        );
        assert_eq!(borsh::to_vec(&quote).expect("quote serializes").len(), 122);
    }

    #[test]
    fn proportional_lamports_preserves_sol_units() {
        assert_eq!(
            proportional_lamports(1_000_000_000, 2_500_000_000).unwrap(),
            2_500_000_000
        );
        assert_eq!(proportional_lamports(1, 999_999_999).unwrap(), 0);
    }

    #[test]
    fn proportional_lamports_rejects_overflow() {
        assert!(proportional_lamports(u64::MAX, 2_000_000_000).is_err());
        assert_eq!(proportional_lamports(1_000_000_000, 100_000_000_000).unwrap(), 100_000_000_000);
    }

    #[test]
    fn settle_instruction_includes_observation_timestamp() {
        let bytes = borsh::to_vec(&SoleilInstruction::Settle {
            oracle_price_cents: 18_000,
            observed_at: 1_900_000_000,
        })
        .expect("settle serializes");
        assert_eq!(bytes[0], 3);
        assert_eq!(bytes.len(), 1 + 8 + 8);
    }

    #[test]
    fn invalid_parameters_have_stable_program_error_code() {
        assert_eq!(SoleilError::InvalidParameters as u32, 8);
    }

    #[test]
    fn put_payout_is_intrinsic_value_times_quantity() {
        let strike: u64 = 18_000;
        let price: u64 = 16_500;
        let quantity: u64 = 2_000_000_000;
        let intrinsic = strike.saturating_sub(price);
        assert_eq!(intrinsic * quantity / 1_000_000_000, 3_000);
    }

    #[test]
    fn call_below_strike_has_zero_payout() {
        let strike: u64 = 18_000;
        let price: u64 = 16_500;
        assert_eq!(price.saturating_sub(strike), 0);
    }
}
