import './env';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: the payment webhook (Phase 5.1) verifies an HMAC over the
  // exact bytes received — a re-serialized JSON body would not match.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.use(cookieParser());
  app.enableCors({
    origin: (origin, callback) => {
      // No origin = mobile apps, curl, server-side calls. Vercel previews get
      // a fresh *.vercel.app host per branch/PR, so match the suffix.
      const frontendUrl = process.env.FRONTEND_URL?.replace(/\/+$/, '');
      let hostname = '';
      try {
        hostname = origin ? new URL(origin).hostname : '';
      } catch {
        // malformed Origin header — falls through to reject
      }
      const isAllowed =
        !origin ||
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        (!!frontendUrl && origin === frontendUrl) ||
        hostname.endsWith('.vercel.app');
      callback(null, isAllowed);
    },
    credentials: true,
  });
  // No host arg: Node binds the IPv6 wildcard '::' dual-stack, so both
  // 'localhost' (which Windows can resolve to ::1) and '127.0.0.1' connect.
  // Binding '0.0.0.0' only accepted IPv4, forcing the frontend workaround
  // that rewrote 'localhost' to '127.0.0.1' before every fetch call.
  await app.listen(process.env.PORT || 3001);
}

bootstrap();
