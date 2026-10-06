import { ConnectionStatus } from '@/features/diagnostics/ConnectionStatus'
import { PlaceholderPage } from '@/app/pages/Placeholder'

export function DashboardPage() {
  return (
    <PlaceholderPage title="Dashboard" phase="Phase 3">
      <ConnectionStatus />
    </PlaceholderPage>
  )
}
export const CollectionsPage = () => <PlaceholderPage title="Collections" phase="Phase 3" />
export const UploadPage = () => <PlaceholderPage title="Upload" phase="Phase 2" />
