import { UdpX32Transport } from './transport';

export interface X32ReachabilitySample {
  reachable: boolean;
  latencyMs?: number;
  p95LatencyMs?: number;
  packetLossPercent: number;
  attempts: number;
  successes: number;
  checkedAt: string;
}

function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * p) - 1)
  );
  return sorted[index];
}

export async function sampleX32Reachability(
  request: () => Promise<void>,
  options: {
    attempts?: number;
    now?: () => Date;
  } = {}
): Promise<X32ReachabilitySample> {
  const attempts = Math.max(1, Math.min(20, options.attempts ?? 5));
  const latencies: number[] = [];
  let successes = 0;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const started = performance.now();
    try {
      await request();
      successes += 1;
      latencies.push(Math.max(0, performance.now() - started));
    } catch {
      // Loss is represented explicitly; one failed probe does not abort the sample.
    }
  }

  const packetLossPercent =
    ((attempts - successes) / attempts) * 100;
  const latencyMs = percentile(latencies, 0.5);
  const p95LatencyMs = percentile(latencies, 0.95);

  return {
    reachable: successes > 0,
    latencyMs,
    p95LatencyMs,
    packetLossPercent,
    attempts,
    successes,
    checkedAt: (options.now?.() ?? new Date()).toISOString()
  };
}

export async function probeX32Reachability(input: {
  targetAddress: string;
  localAddress?: string;
  attempts?: number;
  timeoutMs?: number;
}): Promise<X32ReachabilitySample> {
  const transport = new UdpX32Transport({
    targetAddress: input.targetAddress,
    localAddress: input.localAddress
  });
  const timeoutMs = Math.max(
    100,
    Math.min(3000, input.timeoutMs ?? 400)
  );

  try {
    return await sampleX32Reachability(
      async () => {
        await transport.request('/xinfo', [], timeoutMs);
      },
      { attempts: input.attempts }
    );
  } finally {
    await transport.close();
  }
}
