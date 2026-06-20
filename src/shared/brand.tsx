import brandIcon from "../../assets/branding/quietfolio-logo-small.svg?url";

export { brandIcon };

export function BrandIcon({
  size = 16,
  className
}: {
  size?: number;
  className?: string;
}) {
  return <img src={brandIcon} width={size} height={size} alt="" className={className} draggable={false} />;
}
