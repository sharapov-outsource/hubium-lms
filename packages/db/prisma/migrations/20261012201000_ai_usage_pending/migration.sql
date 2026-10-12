-- Quota reservations: a call holds a PENDING row until it finishes.
ALTER TYPE "AiUsageStatus" ADD VALUE 'PENDING';
