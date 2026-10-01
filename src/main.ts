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
      // Allow requests with no origin (like mobile apps or curl) or matching localhost/frontend
      if (
        !origin ||
        origin.includes('localhost') ||
        origin.includes('127.0.0.1') ||
        (process.env.FRONTEND_URL && origin === process.env.FRONTEND_URL)
      ) {
        callback(null, true);
      } else {
        callback(null, true); // Dev-friendly fallback
      }
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
