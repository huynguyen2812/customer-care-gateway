import { TemplateService } from '../src/templates/template.service';

describe('TemplateService', () => {
  it('renders approved variables and rejects extra variables', async () => {
    const prisma = { messageTemplate: { findUnique: jest.fn().mockResolvedValue({ active: true, body: 'Xin chao {{name}}', allowedVariables: ['name'] }) } };
    const service = new TemplateService(prisma as any);
    await expect(service.render('installation', 'WELCOME', { name: 'An' })).resolves.toBe('Xin chao An');
    await expect(service.render('installation', 'WELCOME', { name: 'An', unsafe: 'x' })).rejects.toThrow('TEMPLATE_VARIABLE_NOT_ALLOWED');
  });
});
