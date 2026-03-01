import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { JwtPayload } from '../types';
import { AppError } from '../middleware/errorHandler';
import { RegisterInput, LoginInput } from '../validators/auth.validator';

// Refresh tokens stored in memory (use Redis in production for multi-instance)
const refreshTokens = new Map<string, { userId: string; email: string; role: string; organizationId?: string; expiresAt: Date }>();

// Clean expired tokens every 30 minutes
setInterval(() => {
  const now = new Date();
  for (const [token, data] of refreshTokens) {
    if (data.expiresAt < now) refreshTokens.delete(token);
  }
}, 30 * 60 * 1000);

export class AuthService {
  async register(_input: RegisterInput) {
    throw new AppError('Registration is disabled. Contact your administrator.', 403);
  }

  async login(input: LoginInput) {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user) {
      throw new AppError('Invalid credentials', 401);
    }

    const isValid = await bcrypt.compare(input.password, user.passwordHash);
    if (!isValid) {
      throw new AppError('Invalid credentials', 401);
    }

    const accessToken = this.generateAccessToken(user.id, user.email, user.role, user.organizationId ?? undefined);
    const refreshToken = this.generateRefreshToken(user.id, user.email, user.role, user.organizationId ?? undefined);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: user.organizationId,
        createdAt: user.createdAt,
      },
      token: accessToken,
      refreshToken,
    };
  }

  async refresh(refreshToken: string) {
    const data = refreshTokens.get(refreshToken);
    if (!data) {
      throw new AppError('Invalid refresh token', 401);
    }
    if (data.expiresAt < new Date()) {
      refreshTokens.delete(refreshToken);
      throw new AppError('Refresh token expired', 401);
    }

    // Verify user still exists and is active
    const user = await prisma.user.findUnique({ where: { id: data.userId } });
    if (!user) {
      refreshTokens.delete(refreshToken);
      throw new AppError('User not found', 401);
    }

    // Rotate: invalidate old refresh token, issue new pair
    refreshTokens.delete(refreshToken);

    const newAccessToken = this.generateAccessToken(user.id, user.email, user.role, user.organizationId ?? undefined);
    const newRefreshToken = this.generateRefreshToken(user.id, user.email, user.role, user.organizationId ?? undefined);

    return { token: newAccessToken, refreshToken: newRefreshToken };
  }

  revokeRefreshToken(refreshToken: string) {
    refreshTokens.delete(refreshToken);
  }

  private generateAccessToken(userId: string, email: string, role: string, organizationId?: string): string {
    const options: jwt.SignOptions = { expiresIn: '1h' };
    return jwt.sign(
      { userId, email, role, organizationId } as JwtPayload,
      env.JWT_SECRET,
      options
    );
  }

  private generateRefreshToken(userId: string, email: string, role: string, organizationId?: string): string {
    const token = crypto.randomBytes(64).toString('hex');
    refreshTokens.set(token, {
      userId,
      email,
      role,
      organizationId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });
    return token;
  }
}

export const authService = new AuthService();
