import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Auth0 JWT `email` claim when present. */
export const AuthEmail = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null => {
    const req = ctx.switchToHttp().getRequest<Request>();
    const email = req.auth?.payload?.email;
    if (typeof email === 'string' && email.trim()) {
      return email.trim();
    }
    return null;
  },
);
