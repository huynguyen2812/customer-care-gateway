import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class TemplateService {
  constructor(private readonly prisma: PrismaService) {}

  async render(installationId: string, code: string, variables: Record<string, unknown>): Promise<string> {
    const template = await this.prisma.messageTemplate.findUnique({ where: { installationId_code: { installationId, code } } });
    if (!template?.active) throw new BadRequestException('TEMPLATE_NOT_APPROVED');
    const supplied = Object.keys(variables).sort();
    const allowed = [...template.allowedVariables].sort();
    if (supplied.some((key) => !allowed.includes(key))) throw new BadRequestException('TEMPLATE_VARIABLE_NOT_ALLOWED');
    const required = [...template.body.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)].map((match) => match[1]);
    if (required.some((key) => variables[key] === undefined || variables[key] === null)) throw new BadRequestException('TEMPLATE_VARIABLE_MISSING');
    return template.body.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_all, key: string) => String(variables[key]));
  }
}
