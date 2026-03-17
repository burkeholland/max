import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Mock all heavy dependencies before importing the server
vi.mock("../copilot/orchestrator.js", () => ({
  sendToOrchestrator: vi.fn(),
  getWorkers: vi.fn(() => new Map()),
  cancelCurrentMessage: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("../telegram/bot.js", () => ({
  sendPhoto: vi.fn(() => Promise.resolve()),
}));

vi.mock("../config.js", () => ({
  config: {
    copilotModel: "test-model",
    apiPort: 0,
  },
  persistModel: vi.fn(),
}));

vi.mock("../store/db.js", () => ({
  searchMemories: vi.fn(() => []),
}));

vi.mock("../copilot/skills.js", () => ({
  listSkills: vi.fn(() => []),
}));

vi.mock("../daemon.js", () => ({
  restartDaemon: vi.fn(() => Promise.resolve()),
}));

import { app } from "./server.js";
import { getWorkers, cancelCurrentMessage } from "../copilot/orchestrator.js";
import { sendPhoto } from "../telegram/bot.js";
import { config, persistModel } from "../config.js";
import { searchMemories } from "../store/db.js";
import { listSkills } from "../copilot/skills.js";

describe("API server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /status", () => {
    it("returns ok status with workers list", async () => {
      const res = await request(app).get("/status");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.workers).toEqual([]);
    });

    it("includes worker details when workers exist", async () => {
      const mockWorkers = new Map([
        ["test-worker", { name: "test-worker", workingDir: "/tmp", status: "running" }],
      ]);
      vi.mocked(getWorkers).mockReturnValue(mockWorkers as any);

      const res = await request(app).get("/status");
      expect(res.body.workers).toEqual([
        { name: "test-worker", workingDir: "/tmp", status: "running" },
      ]);
    });
  });

  describe("GET /sessions", () => {
    it("returns empty array when no workers", async () => {
      vi.mocked(getWorkers).mockReturnValue(new Map());
      const res = await request(app).get("/sessions");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("POST /message", () => {
    it("rejects missing prompt", async () => {
      const res = await request(app).post("/message").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("prompt");
    });

    it("rejects missing connectionId", async () => {
      const res = await request(app).post("/message").send({ prompt: "hello" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("connectionId");
    });
  });

  describe("POST /cancel", () => {
    it("returns cancelled status", async () => {
      vi.mocked(cancelCurrentMessage).mockResolvedValue(true);
      const res = await request(app).post("/cancel");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.cancelled).toBe(true);
    });
  });

  describe("GET /model", () => {
    it("returns current model", async () => {
      const res = await request(app).get("/model");
      expect(res.status).toBe(200);
      expect(res.body.model).toBe("test-model");
    });
  });

  describe("POST /model", () => {
    it("switches model", async () => {
      const res = await request(app).post("/model").send({ model: "gpt-4" });
      expect(res.status).toBe(200);
      expect(res.body.previous).toBe("test-model");
      expect(res.body.current).toBe("gpt-4");
      expect(persistModel).toHaveBeenCalledWith("gpt-4");
    });

    it("rejects missing model", async () => {
      const res = await request(app).post("/model").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("model");
    });
  });

  describe("GET /memory", () => {
    it("returns memories from store", async () => {
      const mockMemories = [{ id: 1, category: "fact", content: "test", source: "user", created_at: "2024-01-01" }];
      vi.mocked(searchMemories).mockReturnValue(mockMemories);

      const res = await request(app).get("/memory");
      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockMemories);
    });
  });

  describe("GET /skills", () => {
    it("returns skills list", async () => {
      const mockSkills = [{ slug: "test", name: "Test", description: "A test", directory: "/tmp", source: "local" }];
      vi.mocked(listSkills).mockReturnValue(mockSkills as any);

      const res = await request(app).get("/skills");
      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockSkills);
    });
  });

  describe("POST /restart", () => {
    it("returns restarting status", async () => {
      const res = await request(app).post("/restart");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("restarting");
    });
  });

  describe("POST /send-photo", () => {
    it("rejects missing photo", async () => {
      const res = await request(app).post("/send-photo").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("photo");
    });

    it("sends photo successfully", async () => {
      vi.mocked(sendPhoto).mockResolvedValue();
      const res = await request(app).post("/send-photo").send({ photo: "https://example.com/img.jpg", caption: "test" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("sent");
      expect(sendPhoto).toHaveBeenCalledWith("https://example.com/img.jpg", "test");
    });

    it("returns 500 on send failure", async () => {
      vi.mocked(sendPhoto).mockRejectedValue(new Error("upload failed"));
      const res = await request(app).post("/send-photo").send({ photo: "/bad/path.jpg" });
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("upload failed");
    });
  });
});
