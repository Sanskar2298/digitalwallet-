import bcrypt from 'bcryptjs';
import { pool } from '../../config/database';
import { ConflictError, UnauthorizedError } from '../../utils/errors';
import { RegisterInput, LoginInput } from './auth.schema';

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

export class AuthService {
  /**
   * Register a new user with hashed password
   */
  async register(input: RegisterInput): Promise<{ id: string; email: string; createdAt: Date }> {
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [input.email.toLowerCase()]
    );

    if (existing.rowCount && existing.rowCount > 0) {
      throw new ConflictError('User with this email already exists');
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(input.password, salt);

    const result = await pool.query<UserRecord>(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, created_at`,
      [input.email.toLowerCase(), passwordHash]
    );

    const user = result.rows[0];
    return {
      id: user.id,
      email: user.email,
      createdAt: user.created_at,
    };
  }

  /**
   * Authenticate a user and return the user record if valid
   */
  async login(input: LoginInput): Promise<{ id: string; email: string }> {
    const result = await pool.query<UserRecord>(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [input.email.toLowerCase()]
    );

    if (result.rowCount === 0) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const user = result.rows[0];
    const isPasswordValid = await bcrypt.compare(input.password, user.password_hash);
    if (!isPasswordValid) {
      throw new UnauthorizedError('Invalid email or password');
    }

    return {
      id: user.id,
      email: user.email,
    };
  }
}

export const authService = new AuthService();
