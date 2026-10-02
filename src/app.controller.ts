import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // Render health check and keep-alive ping target; no DB or auth on purpose.
  @Get('health')
  getHealth(): { status: string } {
    return { status: 'ok' };
  }
}
