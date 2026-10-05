import { AdminShell } from '@/components/admin/shell';

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
