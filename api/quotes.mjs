import { handleGatewayRequest } from '../maker-gateway/server.mjs'

export default function quotes(request, response) {
  const query = request.url?.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
  request.url = `/quotes${query}`
  return handleGatewayRequest(request, response)
}
