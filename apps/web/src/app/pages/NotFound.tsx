import { Link } from 'react-router'
import { EmptyState } from '@/components/ui'
import { routes } from '@/lib/routes'

export function NotFoundPage() {
  return (
    <EmptyState
      title="Page not found"
      description="The page you are looking for doesn't exist."
      action={
        <Link to={routes.dashboard} className="font-medium text-accent hover:underline">
          Go to Dashboard
        </Link>
      }
    />
  )
}
