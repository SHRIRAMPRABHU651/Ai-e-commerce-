import { PortalShell } from '@/components/supplier-portal';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <PortalShell>{children}</PortalShell>;
}
