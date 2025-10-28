import React from 'react';

function StripeBoost({ playerName, close }) {
  const handleBuy = async () => {
    const res = await fetch('http://localhost:4000/stripe/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerName }),
    });
    const { url } = await res.json();
    window.open(url, '_blank');
    close();
  };

  return (
    <div className="stripe-modal">
      <h3>Buy 5 Points Boost for $0.99</h3>
      <button className="button" onClick={handleBuy}>Pay with Stripe</button>
      <button className="button" onClick={close}>Cancel</button>
    </div>
  );
}

export default StripeBoost;
