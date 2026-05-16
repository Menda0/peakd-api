import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AUTH0_CONFIG_KEY } from '../config/auth0.config';
import { hasRoleInPayload } from './auth-roles';
import { Auth0JwtGuard } from './auth0-jwt.guard';

@Injectable()
export class Auth0AdminGuard implements CanActivate {
  constructor(
    private readonly jwtGuard: Auth0JwtGuard,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.jwtGuard.canActivate(context);
    const req = context.switchToHttp().getRequest<Request>();
    const payload = req.auth?.payload as Record<string, unknown> | undefined;
    if (!payload) {
      throw new ForbiddenException('Admin role required');
    }
    const audience = this.config.get<string>(`${AUTH0_CONFIG_KEY}.audience`);
    if (!hasRoleInPayload(payload, 'admin', audience)) {
      throw new ForbiddenException('Admin role required');
    }
    return true;
  }
}
