/** Synthetic engine fixture client. Only real scoped MCP RPCs resolve a deferred target; never a host bypass. */
export function mcpDirectoryClient(rpc) {
  const result = row => {
    if (row?.jsonrpc === '2.0') {
      if (row.error) throw new Error('Synthetic MCP RPC refused.');
      return row.result;
    }
    return row;
  };
  const list = async () => {
    const body = result(await rpc('tools/list', {}));
    if (!Array.isArray(body?.tools)) throw new Error('Synthetic MCP catalog missing.');
    return body.tools;
  };
  const find = async (canonicalName, expectedAlias) => {
    const catalog = await list();
    const direct = catalog.filter(tool => /^dx_[a-f0-9]{24}$/.test(tool.name)
      && (expectedAlias ? tool.name === expectedAlias : tool.title?.startsWith(canonicalName + ' ')));
    if (direct.length > 1) throw new Error('Synthetic MCP target is ambiguous.');
    if (direct.length === 1) return { ...direct[0], viaDirectory: false };
    for (const name of ['dx_catalog_search', 'dx_catalog_describe', 'dx_catalog_call'])
      if (!catalog.some(tool => tool.name === name)) throw new Error('Synthetic MCP directory missing.');
    const searched = result(await rpc('tools/call', { name: 'dx_catalog_search', arguments: { query: canonicalName, limit: 20 } }));
    if (searched?.isError || !Array.isArray(searched?.structuredContent?.tools)) throw new Error('Synthetic MCP search refused.');
    const matches = searched.structuredContent.tools.filter(tool => expectedAlias ? tool.alias === expectedAlias : tool.title === canonicalName);
    if (matches.length !== 1 || !/^dx_[a-f0-9]{24}$/.test(matches[0].alias)) throw new Error('Synthetic MCP target missing or ambiguous.');
    const described = result(await rpc('tools/call', { name: 'dx_catalog_describe', arguments: { alias: matches[0].alias } }));
    if (described?.isError || described?.structuredContent?.name !== matches[0].alias) throw new Error('Synthetic MCP description refused.');
    return { ...described.structuredContent, viaDirectory: true };
  };
  const call = (tool, callId, input = {}) => rpc('tools/call', {
    name: tool.viaDirectory ? 'dx_catalog_call' : tool.name,
    arguments: tool.viaDirectory ? { alias: tool.name, callId, input } : { callId, input },
  });
  return { list, find, call, result };
}
export const MCP_DIRECTORY_NAMES = Object.freeze(['dx_catalog_search', 'dx_catalog_describe', 'dx_catalog_call']);
