import { Installation, SourceProduct } from '@prisma/client';

export type InstallationContext = {
  installation: Installation;
  installationId: string;
  tenantId: string;
  sourceProduct: SourceProduct;
  scopes: string[];
};

declare module 'http' {
  interface IncomingMessage { installationContext?: InstallationContext; rawBody?: Buffer; }
}
