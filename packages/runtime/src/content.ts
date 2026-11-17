/** MCP-neutral result shape; this module does not depend on the MCP SDK. */
export function mcpContent(value: unknown) {
  const result = value as Record<string, any> | null;
  const screenshot = result?.screenshot;
  if (!screenshot?.data)
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(value, null, 2) },
      ],
    };
  const { data, ...metadata } = screenshot;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ...result, screenshot: metadata }, null, 2),
      },
      {
        type: "image" as const,
        data: String(data),
        mimeType: String(metadata.mimeType ?? "image/png"),
      },
    ],
  };
}
