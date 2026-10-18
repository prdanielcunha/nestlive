import { createServer, createConnection, type Server } from 'node:net';

/** Held for the whole supervisor lifetime; loopback only, no public control surface. */
export async function reserveSupervisor(port: number): Promise<Server> {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return server;
}
export async function portOccupied(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const finish = (occupied: boolean) => { socket.destroy(); resolve(occupied); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}
