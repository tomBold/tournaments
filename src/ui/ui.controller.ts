import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Copied next to the compiled file by the Nest CLI (see "assets" in nest-cli.json). */
const PAGE = readFileSync(join(__dirname, 'index.html'), 'utf8');

/** Minimal browser UI for trying the API by hand. */
@ApiExcludeController()
@Controller()
export class UiController {
  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  page(): string {
    return PAGE;
  }
}
