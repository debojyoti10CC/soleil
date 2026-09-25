import { handleGatewayRequest } from '../maker-gateway/server.mjs'

export default function transaction(request, response) {
  const query = request.url?.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
  request.url = `/transaction${query}`
  return handleGatewayRequest(request, response)
}
