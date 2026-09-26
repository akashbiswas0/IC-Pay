import { CreditCard } from "lucide-react";
export default function Brand() {
  return (
    <a className="brand" href="/" aria-label="IC Pay home">
      <span className="brand-mark">
        <CreditCard size={22} strokeWidth={1.8} />
      </span>
      <span>
        IC Pay
        <span className="brand-caption">A familiar tap. A new account.</span>
      </span>
    </a>
  );
}
