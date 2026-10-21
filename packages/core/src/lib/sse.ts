// Server-sent events between the processes of Hubium: the cloud's stream to its nodes, the
// node agent's stream to the node's web server.

/** The data of each event of a stream, as it arrives. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''));
      if (data.length) yield data.join('\n');
      end = buffer.indexOf('\n\n');
    }
  }
}

/** An event with JSON data. */
export const sseEvent = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};
