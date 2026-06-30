import { SignUp } from '@clerk/nextjs';

export default function Page() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-surface py-12 px-4 sm:px-6 lg:px-8">
      <SignUp />
    </main>
  );
}
