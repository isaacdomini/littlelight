import {
  idParamsSchema,
  uploadFileParamsSchema,
  uploadFileSchema,
  uploadFilesRegisterRequestSchema,
  uploadFilesRegisterResponseSchema,
  uploadParamsSchema,
  uploadPartsResponseSchema,
  uploadSessionCreateSchema,
  uploadSessionSchema,
} from "@tinyglow/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requireAuth } from "../auth";
import {
  abortFile,
  completeFile,
  createSession,
  finishSession,
  getParts,
  getSession,
  registerFiles,
} from "./service";

// `/babies/:id/uploads` and `/uploads/…` (docs/plans/step-4.md 2.4). Thin handlers: validation
// by the shared zod schemas, behaviour and authorization in `./service` (RLS + the upload-files
// session-owner trigger). Responses never carry GPS, notes beyond the session's own batch
// details, or `analysis`/original URLs; part URLs only in register/parts responses.

export function uploadsRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: "POST",
    url: "/babies/:id/uploads",
    schema: {
      params: idParamsSchema,
      body: uploadSessionCreateSchema,
      response: { 201: uploadSessionSchema },
    },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const session = await createSession(request, request.params.id, request.body);
      return reply.code(201).send(session);
    },
  });

  r.route({
    method: "GET",
    url: "/uploads/:sessionId",
    schema: { params: uploadParamsSchema, response: { 200: uploadSessionSchema } },
    preHandler: requireAuth,
    // Polled every 1.5 s while files are being ingested; only log problems.
    logLevel: "warn",
    handler: async (request) => getSession(request, request.params.sessionId),
  });

  r.route({
    method: "POST",
    url: "/uploads/:sessionId/files",
    schema: {
      params: uploadParamsSchema,
      body: uploadFilesRegisterRequestSchema,
      response: { 200: uploadFilesRegisterResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request) => ({
      files: await registerFiles(request, request.params.sessionId, request.body.files),
    }),
  });

  r.route({
    method: "GET",
    url: "/uploads/:sessionId/files/:fileId/parts",
    schema: { params: uploadFileParamsSchema, response: { 200: uploadPartsResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) => getParts(request, request.params.sessionId, request.params.fileId),
  });

  r.route({
    method: "POST",
    url: "/uploads/:sessionId/files/:fileId/complete",
    schema: { params: uploadFileParamsSchema, response: { 200: uploadFileSchema } },
    preHandler: requireAuth,
    handler: async (request) =>
      completeFile(request, request.params.sessionId, request.params.fileId),
  });

  r.route({
    method: "DELETE",
    url: "/uploads/:sessionId/files/:fileId",
    schema: { params: uploadFileParamsSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      await abortFile(request, request.params.sessionId, request.params.fileId);
      return reply.code(204).send();
    },
  });

  r.route({
    method: "POST",
    url: "/uploads/:sessionId/finish",
    schema: { params: uploadParamsSchema, response: { 200: uploadSessionSchema } },
    preHandler: requireAuth,
    handler: async (request) => finishSession(request, request.params.sessionId),
  });
}
