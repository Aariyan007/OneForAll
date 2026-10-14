import { Skeleton } from "@/components/ui/data";

// Shown while the server verifies access and loads the analysis.
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-6xl" aria-busy="true" aria-label="Loading repository graph">
      <Skeleton className="h-3 w-64" />
      <div className="mt-5 flex items-start gap-3.5">
        <Skeleton className="size-10 rounded-xl" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
      </div>
      <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[84px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="mt-4 h-28 rounded-xl" />
      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Skeleton className="h-[560px] rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
