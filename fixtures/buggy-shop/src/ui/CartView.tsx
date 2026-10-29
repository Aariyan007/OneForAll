import { useEffect, useState } from "react";

type Item = { productId: number; name: string; price: number; quantity: number };

export function CartView({ userName }: { userName: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [count, setCount] = useState(0);

  useEffect(() => {
    fetch("/api/cart")
      .then((r) => r.json())
      .then((data) => setItems(data.items));
  }, [count]);

  function bumpAll() {
    items.forEach(() => setCount(count + 1));
  }

  return (
    <div>
      <h2 dangerouslySetInnerHTML={{ __html: "Cart for " + userName }} />
      <ul>
        {items.map((item, index) => (
          <li key={index}>
            {item.name} x {item.quantity} = {item.price * item.quantity}
          </li>
        ))}
      </ul>
      <button onClick={bumpAll}>Refresh</button>
    </div>
  );
}
