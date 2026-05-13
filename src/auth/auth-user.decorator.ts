import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/** Auth0 subject (`sub`) from validated JWT. */
export const AuthUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request>();
    const sub = req.auth?.payload?.sub;
    if (typeof sub !== 'string' || !sub) {
      throw new UnauthorizedException('Missing subject');
    }
    return sub;
  },
);
