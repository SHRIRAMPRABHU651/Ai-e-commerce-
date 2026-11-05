'use client';
import { PageHeader, useAdmin } from '@/components/admin/kit';
import { FinanceConsole } from '@/components/finance';
import { EmptyState } from '@orvia/ui';

export default function Page() {
  const { can } = useAdmin();
  if (!can('finance:read')) return <EmptyState title="No access" body="You need the finance:read permission to view this page." />;
  return (
    <>
      <PageHeader title="Finance" subtitle="Ledger, profit and cash for real orders. GMV, net sales, contribution and profit are different numbers; every figure says whether it is actual, mixed or an estimate, and shows “unavailable” rather than inventing data." />
      <FinanceConsole />
    </>
  );
}
