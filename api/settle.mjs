import { handleGatewayRequest } from '../maker-gateway/server.mjs'

export default function settle(request, response) {
  const query = request.url?.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
  request.url = `/settle${query}`
  return handleGatewayRequest(request, response)
}
