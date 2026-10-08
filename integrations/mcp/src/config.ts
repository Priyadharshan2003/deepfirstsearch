import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { getAddress, parseUnits, type Address, type Hex } from "viem";
import { z } from "zod";

const usdc = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'USDC amounts are decimal strings, e.g. "0.05"')
  .transform((v) => parseUnits(v, 6))
  .refine((v) => v > 0n, "must be positive");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((v) => getAddress(v));
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v as Hex);

const Merchant = z.object({
  origin: z.string().url(),
  payTo: address,
  /** Owner-signed intent for this merchant (needed only when the payer is funded from a vault). */
  intentId: bytes32.optional(),
  /** Expected price per call. */
  price: usdc,
  /** Allowed overpay over `price`, in percent (default 0). */
  tolerancePct: z.number().min(0).max(100).default(0),
  /** Hard cap per payment. */
  maxPerTx: usdc,
  /** Spend cap for this merchant within one plan window. */
  maxSpend: usdc,
  label: z.string().max(80).optional(),
  /** Optional timeout override (e.g. for long-running merchants) */
  maxTimeoutSeconds: z.number().int().min(10).max(86400).optional(),
});

export const Config = z
  .object({
    network: z.enum(["eip155:8453", "eip155:84532"]),
    rpcUrl: z.string().url().optional(),
    /** BudgetVault that tops up each merchant's payer. Omit to use payers you fund yourself. */
    vault: address.optional(),
    /** Top-up size. Must be <= the intents' trancheCap and maxPerTx. */
    tranche: usdc.optional(),
    merchants: z.array(Merchant).min(1),
    /** The plan is sealed from this config at start and re-sealed (from this config only) every window. */
    planWindowHours: z.number().positive().max(24 * 30).default(24),
    periodBudget: z.object({ amount: usdc, hours: z.number().positive() }).optional(),
    /** Payments above this need a human. This server has no approval channel, so they are refused. */
    approvalAbove: usdc.optional(),
    /** Set true if the agent can also read private data: then every payment needs a human (Rule of Two). */
    sessionHasSensitiveData: z.boolean().default(false),
    /** Append-only, hash-chained audit log (JSONL). */
    auditLog: z.string().optional(),
    /** Maximum response body returned to the model, in characters. */
    maxResponseChars: z.number().int().positive().max(1_000_000).default(20_000),
  })
  .superRefine((c, ctx) => {
    if (c.vault && (!c.tranche || c.merchants.some((m) => !m.intentId)))
      ctx.addIssue({ code: "custom", message: "with a vault, set `tranche` and an `intentId` for every merchant" });
    for (const m of c.merchants) {
      if (m.maxPerTx > m.maxSpend) ctx.addIssue({ code: "custom", message: `${m.origin}: maxPerTx is above maxSpend` });
      if (c.tranche && c.tranche < m.maxPerTx)
        ctx.addIssue({ code: "custom", message: `${m.origin}: tranche must cover one payment (tranche >= maxPerTx)` });
    }
    const origins = c.merchants.map((m) => new URL(m.origin).origin);
    if (new Set(origins).size !== origins.length) ctx.addIssue({ code: "custom", message: "duplicate merchant origin" });
  });
export type Config = z.infer<typeof Config>;

export type Secrets = { agentKey?: Hex; burnerSeed: Uint8Array };

export function loadConfig(path: string): Config {
  return Config.parse(JSON.parse(readFileSync(path.replace(/^~(?=\/)/, homedir()), "utf8")));
}

/** Secrets come only from the environment, never from the config file or the model. */
export function loadSecrets(env: NodeJS.ProcessEnv, needsAgentKey: boolean): Secrets {
  const seed = env.AGENT_PAY_BURNER_SEED;
  if (!seed || !/^0x[0-9a-fA-F]{64,}$/.test(seed)) throw new Error("AGENT_PAY_BURNER_SEED must be a 32-byte (or longer) hex secret");
  const agentKey = env.AGENT_PAY_AGENT_KEY;
  if (needsAgentKey && (!agentKey || !/^0x[0-9a-fA-F]{64}$/.test(agentKey)))
    throw new Error("AGENT_PAY_AGENT_KEY (the intent's agent key) is required when a vault is configured");
  return { agentKey: agentKey as Hex | undefined, burnerSeed: Buffer.from(seed.slice(2), "hex") };
}

export type { Address };
