import { z } from "zod";

export const capacityCheckSchema = z.object({
  enabled: z.boolean(),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  minRemainingPercent: z.number().min(0).max(100),
  blockNewWork: z.boolean().optional(),
  failOpen: z.boolean().optional(),
  remainingPercentPatterns: z.array(z.string().min(1)).optional(),
  usedPercentPatterns: z.array(z.string().min(1)).optional(),
  windowLabel: z.string().min(1).optional(),
});

export type CapacityCheckConfigInput = z.input<typeof capacityCheckSchema>;
