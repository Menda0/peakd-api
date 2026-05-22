import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { auth } from 'express-oauth2-jwt-bearer';
import type { Handler } from 'express';
import { AUTH0_CONFIG_KEY } from '../config/auth0.config';

@Injectable()
export class Auth0JwtGuard implements CanActivate {
  private readonly jwtCheck: Handler;

  constructor(private readonly config: ConfigService) {
    const issuerBaseURL = this.config.getOrThrow<string>(
      `${AUTH0_CONFIG_KEY}.issuerBaseURL`,
    );
    const audience = this.config.getOrThrow<string>(
      `${AUTH0_CONFIG_KEY}.audience`,
    );
    this.jwtCheck = auth({
      audience,
      issuerBaseURL,
    });
  }

  canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    return new Promise((resolve, reject) => {
      this.jwtCheck(req, res, (err?: unknown) => {
        if (err) {
          const msg = err instanceof Error ? err.message : 'Unauthorized';
          reject(new UnauthorizedException(msg));
          return;
        }
        const sub = req.auth?.payload?.sub;
        if (typeof sub !== 'string' || !sub) {
          reject(new UnauthorizedException('Missing subject'));
          return;
        }
        resolve(true);
      });
    });
  }
}
