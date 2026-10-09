// Chat module (docs/plans/step-7.md 2.8). Registration for the API wiring (task 7.8):
//
//   import { chatRoutes } from "./chat";
//   import { searchRoutes } from "./search";
//   const deps = { ai: app.ai /* { chat, embedder } */, settings: { ...searchEnv, ...chatEnv,
//                  AI_BABY_MONTHLY_BUDGET_USD } };
//   searchRoutes(app, deps); chatRoutes(app, deps);
//
// Register after auth (the routes use `requireAuth`). The POST route streams over SSE with
// `reply.hijack()`: the server's `keepAliveTimeout` must exceed the SSE keepalive (15 s) and the
// request timeout must not cut a turn (plan 2.9). Add `req.body.text` to the pino redact list.
export {
  type AgentDeps,
  type AgentEvent,
  type AgentInput,
  runChatTurn,
  type TurnResult,
} from "./agent";
export { type CitationFilter, createCitationFilter } from "./citations";
export { chatRoutes, secondsToNextUtcMonth } from "./routes";
export { type ChatEventStream, openChatEventStream } from "./sse";
export { runTool, type ToolContext, type ToolOutcome, toolError } from "./tools";
