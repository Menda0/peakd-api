import { registerAs } from '@nestjs/config';

export const AUTH0_CONFIG_KEY = 'auth0';

export interface Auth0ConfigValues {
  issuerBaseURL: string;
  audience: string;
}

export const auth0Config = registerAs(
  AUTH0_CONFIG_KEY,
  (): Auth0ConfigValues => ({
    issuerBaseURL: (process.env.AUTH0_ISSUER_BASE_URL ?? '').replace(/\/+$/, ''),
    audience: process.env.AUTH0_AUDIENCE ?? '',
  }),
);
