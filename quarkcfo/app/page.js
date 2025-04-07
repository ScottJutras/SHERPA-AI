export default function Home() {
  return (
    <div className="container mx-auto">
      <header className="text-center py-10">
        <h1 className="text-4xl font-bold">QuarkCFO</h1>
        <p className="text-xl">Your quantum-powered financial orb—anywhere, anytime.</p>
      </header>
      <section className="pricing py-10">
        <h2 className="text-3xl font-bold text-center">Financial Deep Dive</h2>
        <p className="text-center mb-6">One-time CFO insights—upload, analyze, win.</p>
        <div className="plans flex flex-wrap justify-center gap-6">
          <div className="plan border rounded-lg p-6 w-80">
            <h3 className="text-2xl">Tier 1 - $50</h3>
            <ul className="my-4">
              <li>Historical analysis</li>
              <li>Fraud & savings detection</li>
              <li>Strategy + charts</li>
            </ul>
            <button className="cta bg-blue-600 text-white py-2 px-4 rounded hover:bg-blue-700">Buy Now</button>
          </div>
          {/* Add Tier 2, Tier 3 later */}
        </div>
      </section>
      <section className="pricing py-10">
        <h2 className="text-3xl font-bold text-center">WhatsApp Daily Assistant</h2>
        <p className="text-center mb-6">Your quark-sized CFO—text, track, thrive.</p>
        <div className="plans flex flex-wrap justify-center gap-6">
          <div className="plan border rounded-lg p-6 w-80">
            <h3 className="text-2xl">Free</h3>
            <p className="price text-4xl font-bold">$0<span className="text-lg">/month</span></p>
            <ul className="my-4">
              <li>Basic cash tracking</li>
              <li>Manual categorization</li>
            </ul>
            <button className="cta bg-blue-600 text-white py-2 px-4 rounded hover:bg-blue-700">Start Free</button>
          </div>
          {/* Add Pro, Elite later */}
        </div>
      </section>
    </div>
  );
}