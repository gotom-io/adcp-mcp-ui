export function getMcpSessionIdShort(sessionId) {
    return 'sid_' + sessionId.slice(0, 8);
}
