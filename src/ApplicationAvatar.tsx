export function ApplicationAvatar({
  appCode,
  iconDataUrl,
  large = false,
}: {
  appCode: string;
  iconDataUrl?: string | null;
  large?: boolean;
}) {
  return (
    <span className={`app-avatar${large ? " large-avatar" : ""}`}>
      {iconDataUrl ? <img src={iconDataUrl} alt="" /> : appCode.slice(0, 2)}
    </span>
  );
}
