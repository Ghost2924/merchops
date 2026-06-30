import OrgGate from '@/components/org/OrgGate';

export const dynamic = 'force-dynamic';

export default function AuthenticatedAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <OrgGate>{children}</OrgGate>;
}
