import { z } from "zod";
import { commandInputSchema, type CommandInput } from "./command-config.js";

export const capacityCheckSchema = z.object({
  enabled: z.boolean(),
  command: commandInputSchema,
  cwd: z.string().min(1).optional(),
  minRemainingPercent: z.number().min(0).max(100),
  blockNewWork: z.boolean().optional(),
  failOpen: z.boolean().optional(),
  remainingPercentPatterns: z.array(z.string().min(1)).optional(),
  usedPercentPatterns: z.array(z.string().min(1)).optional(),
  windowLabel: z.string().min(1).optional(),
});

export type CapacityCheckConfigInput = z.input<typeof capacityCheckSchema>;
export type CapacityCheckCommand = CommandInput;
