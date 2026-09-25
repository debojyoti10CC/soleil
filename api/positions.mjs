import { handleGatewayRequest } from '../maker-gateway/server.mjs'

export default function positions(request, response) {
  const query = request.url?.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
  request.url = `/positions${query}`
  return handleGatewayRequest(request, response)
}
