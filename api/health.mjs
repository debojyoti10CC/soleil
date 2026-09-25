import { handleGatewayRequest } from '../maker-gateway/server.mjs'

export default function health(request, response) {
  request.url = '/health'
  return handleGatewayRequest(request, response)
}
