'use client';
import { PageHeader } from '@/components/admin/kit';
import { CreatorsAdmin } from '@/components/creators-admin';

export default function Page() {
  return (
    <>
      <PageHeader title="Creators & loyalty" subtitle="Applications, commissions, payouts, fraud review, referrals and loyalty. Real data only; every action is audited." />
      <CreatorsAdmin />
    </>
  );
}
