import { Router } from "express";
import { login, logout, refresh, register } from "../controllers/auth.controller.js";
import { requireAuthentication } from "../middleware/auth.middleware.js";

export const authRouter = Router();
authRouter.post("/register", register);
authRouter.post("/login", login);
authRouter.post("/refresh", refresh);
authRouter.post("/logout", requireAuthentication, logout);
