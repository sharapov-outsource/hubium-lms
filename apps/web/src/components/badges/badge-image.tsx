import { cn } from '@hubium/ui/cn';

/** A badge's image, from its public Open Badges address. */
export function BadgeImage({
  badgeId,
  name,
  size = 40,
  className,
}: {
  badgeId: string;
  name: string;
  /** Tailwind size steps: 10, 16, 40. */
  size?: 10 | 16 | 40;
  className?: string;
}) {
  const px = size * 4;
  return (
    // biome-ignore lint/performance/noImgElement: served by the badges route, PNG or SVG
    <img
      src={`/api/badges/images/${badgeId}`}
      alt={name}
      width={px}
      height={px}
      className={cn(
        'object-contain',
        size === 40 ? 'size-40' : size === 16 ? 'size-16' : 'size-10',
        className,
      )}
    />
  );
}
