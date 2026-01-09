import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICES = {
  monthly: process.env.STRIPE_MONTHLY_PRICE_ID,
  lifetime: process.env.STRIPE_LIFETIME_PRICE_ID
};

export async function createCheckoutSession(user, planType, baseUrl) {
  const isSubscription = planType === 'monthly';

  const sessionConfig = {
    customer_email: user.email,
    client_reference_id: user.id,
    mode: isSubscription ? 'subscription' : 'payment',
    line_items: [{
      price: PRICES[planType],
      quantity: 1
    }],
    success_url: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/payment/cancel`,
    metadata: {
      userId: user.id,
      planType: planType
    }
  };

  // For subscriptions, add 7-day free trial and allow promotion codes
  if (isSubscription) {
    sessionConfig.allow_promotion_codes = true;
    sessionConfig.subscription_data = {
      trial_period_days: 7
    };
  }

  const session = await stripe.checkout.sessions.create(sessionConfig);
  return session;
}

export async function createPortalSession(stripeCustomerId, returnUrl) {
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl
  });
  return session;
}

export async function getCheckoutSession(sessionId) {
  return await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['subscription', 'customer']
  });
}

export async function getSubscription(subscriptionId) {
  return await stripe.subscriptions.retrieve(subscriptionId);
}

export function constructWebhookEvent(payload, signature) {
  return stripe.webhooks.constructEvent(
    payload,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}

export async function createCustomer(email, name) {
  return await stripe.customers.create({
    email,
    name
  });
}

export { stripe, PRICES };
