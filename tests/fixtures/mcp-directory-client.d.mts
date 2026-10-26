export interface ResolvedFixtureMcpTool { name: string; title?: string; description?: string; viaDirectory: boolean; inputSchema?: unknown }
export declare function mcpDirectoryClient(rpc: (method: string, params?: any) => Promise<any>): {
 list(): Promise<any[]>;
 find(canonicalName: string, expectedAlias?: string): Promise<ResolvedFixtureMcpTool>;
 call(tool: ResolvedFixtureMcpTool, callId: string, input?: any): Promise<any>;
 result(row: any): any;
};
export declare const MCP_DIRECTORY_NAMES: readonly string[];
