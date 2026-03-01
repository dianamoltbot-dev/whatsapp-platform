import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { PaginatedResponse } from '../types';

interface CreateOrgInput {
  name: string;
  slug: string;
}

interface UpdateOrgInput {
  name?: string;
  slug?: string;
  isActive?: boolean;
  plan?: string;
}

export class OrganizationService {
  async list(page = 1, limit = 20): Promise<PaginatedResponse<any>> {
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      prisma.organization.findMany({
        include: {
          _count: { select: { users: true, botConfigs: true, clients: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.organization.count(),
    ]);

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getById(id: string) {
    return prisma.organization.findUnique({
      where: { id },
      include: {
        users: { select: { id: true, email: true, name: true, role: true, createdAt: true } },
        botConfigs: { select: { id: true, name: true, model: true, whatsappPhoneNumberId: true, createdAt: true } },
        _count: { select: { clients: true } },
      },
    });
  }

  async create(input: CreateOrgInput) {
    const existing = await prisma.organization.findUnique({ where: { slug: input.slug } });
    if (existing) {
      throw new AppError('Organization slug already exists', 409);
    }

    return prisma.organization.create({
      data: input,
    });
  }

  async update(id: string, input: UpdateOrgInput) {
    if (input.slug) {
      const existing = await prisma.organization.findFirst({
        where: { slug: input.slug, NOT: { id } },
      });
      if (existing) {
        throw new AppError('Organization slug already exists', 409);
      }
    }

    return prisma.organization.update({
      where: { id },
      data: input,
    });
  }

  async delete(id: string) {
    const org = await prisma.organization.findUnique({
      where: { id },
      include: { _count: { select: { users: true, botConfigs: true, clients: true } } },
    });

    if (!org) throw new AppError('Organization not found', 404);

    if (org._count.clients > 0 || org._count.botConfigs > 0) {
      throw new AppError('Cannot delete organization with existing bots or clients', 400);
    }

    return prisma.organization.delete({ where: { id } });
  }
}

export const organizationService = new OrganizationService();
