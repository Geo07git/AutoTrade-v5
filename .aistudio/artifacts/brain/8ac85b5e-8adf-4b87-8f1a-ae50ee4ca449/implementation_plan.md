# Implementation Plan - Volume Spike & Breakout Strategy in Parallel with Momentum

This plan outlines the implementation of a new **Volume Spike & Candle Breakout** entry strategy running in parallel alongside the existing **Momentum Score** in AutoTrade-v5, allowing comparative testing and dual-signal entry validation as requested by the user.

## Proposed Changes

### 1. New Volume Spike & Breakout Engine (`src/server/engine/VolumeSpikeEngine.ts`)
- Implement a detection module that analyzes recent price action and volume anomalies:
  - **Volume Spike**: Current candle volume > X times the average volume of the last N periods (e.g. 2.5x over 20 periods).
  - **Candle Breakout**: Price breaking above recent resistance / previous high (or below for short) accompanied by the volume spike.
- Return a normalized confidence score (0-100) and entry signal (`BUY` / `SELL` / `NONE`).

### 2. Update Trade Pipeline (`src/server/pipeline/TradeBot.ts`)
- Integrate `VolumeSpikeEngine` alongside `MomentumEngine`.
- Evaluate both engines in parallel for each symbol scan.
- Log performance metrics for both methods independently in `SymbolStatsTracker` or experiment logs so the user can analyze correlation and win-rate comparison between Momentum vs. Volume Spike & Breakout.
- Provide a configuration / mode flag to allow parallel evaluation or weighted scoring.

### 3. Frontend Dashboard Updates (`src/components/BloombergTerminal.tsx` & stats views)
- Add UI indicators for **Volume Spike / Breakout** status alongside Momentum Score in the live scanner and Bloomberg terminal.
- Display parallel performance comparison metrics.

## Verification Plan

1. **Build Verification**: Run `compile_applet` to ensure TypeScript compilation and no syntax/import errors.
2. **Backend Engine Test**: Verify that volume spike calculations correctly trigger signals on simulated price/volume surges.
3. **End-to-End Test**: Trigger a build and verify the CI/CD pipeline deploys successfully to OCI.
