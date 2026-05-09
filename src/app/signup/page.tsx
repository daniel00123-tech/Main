import { serviceCategories } from "@/lib/validation";
import { signupAction } from "@/app/signup/actions";

export default function SignupPage() {
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-3xl font-black">Create account</h1>
        <p className="text-slate-600">Customers can post immediately. Suppliers require admin approval.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <form action={signupAction} className="card grid gap-4">
          <input type="hidden" name="role" value="CUSTOMER" />
          <h2 className="text-xl font-black">Customer signup</h2>
          <label>
            Contact name
            <input name="name" required minLength={2} />
          </label>
          <label>
            Email
            <input name="email" type="email" required />
          </label>
          <label>
            Phone
            <input name="phone" required minLength={7} />
          </label>
          <label>
            Password
            <input name="password" type="password" required minLength={8} />
          </label>
          <label>
            Company name
            <input name="companyName" required />
          </label>
          <label>
            Location
            <input name="location" placeholder="London" required />
          </label>
          <button type="submit">Create customer account</button>
        </form>

        <form action={signupAction} className="card grid gap-4">
          <input type="hidden" name="role" value="SUPPLIER" />
          <h2 className="text-xl font-black">Supplier signup</h2>
          <label>
            Business name
            <input name="businessName" required />
          </label>
          <label>
            Contact name
            <input name="contactName" required />
          </label>
          <label>
            Email
            <input name="email" type="email" required />
          </label>
          <label>
            Phone
            <input name="phone" required minLength={7} />
          </label>
          <label>
            Password
            <input name="password" type="password" required minLength={8} />
          </label>
          <label>
            Location
            <input name="location" placeholder="London" required />
          </label>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-bold text-slate-700">Services</legend>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {serviceCategories.map((category) => (
                <label key={category} className="flex items-center gap-2 font-normal">
                  <input className="w-auto" type="checkbox" name="services" value={category} />
                  {category}
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            Description
            <textarea name="description" minLength={20} required />
          </label>
          <label>
            Rate
            <input name="rate" type="number" min="1" step="0.01" required />
          </label>
          <label>
            Rate type
            <select name="rateType" defaultValue="HOURLY">
              <option value="HOURLY">Hourly</option>
              <option value="FIXED">Fixed</option>
            </select>
          </label>
          <label>
            Availability
            <input name="availability" placeholder="Weekdays, emergency callouts" required />
          </label>
          <button type="submit">Create supplier account</button>
        </form>
      </div>
    </div>
  );
}
